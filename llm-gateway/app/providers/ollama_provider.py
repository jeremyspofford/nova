"""
Ollama provider — direct HTTP client for local/remote model serving.
Health-aware: probes Ollama with a fast 3s check before routing requests.
When unreachable, fires Wake-on-LAN in the background and raises immediately.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from typing import AsyncIterator

import httpx
from app.config import settings
from app.providers.base import ModelProvider
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


def _tool_to_ollama(tool) -> dict:
    """Convert a ToolDefinition to Ollama's /api/chat tools format
    (OpenAI-compatible function wrapper)."""
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    }


def _parse_ollama_tool_calls(raw_calls: list) -> list[ToolCall]:
    """Convert Ollama tool_calls into Nova's ToolCall contract."""
    out: list[ToolCall] = []
    for tc in raw_calls or []:
        fn = tc.get("function", {}) or {}
        args = fn.get("arguments", {})
        # Ollama sometimes returns a dict, sometimes a JSON-encoded string
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        out.append(ToolCall(
            id=tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
            name=fn.get("name", ""),
            arguments=args if isinstance(args, dict) else {},
        ))
    return out


# Some models' Ollama templates lack native tool support and instead print the
# tool call as plain text in `content` (e.g. certain qwen2.5-coder builds emit
# `{"name": "run_shell", "arguments": {...}}`). Without recovery the agent
# narrates tool use but never acts. These patterns extract such calls.
_TOOL_CALL_TAG_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
_FENCE_RE = re.compile(r"```(?:json|tool_call)?", re.IGNORECASE)
# A JSON object allowing a single level of nesting (covers {"arguments": {...}}).
_JSON_OBJ_RE = re.compile(r"\{(?:[^{}]|\{[^{}]*\})*\}")


def _extract_text_tool_calls(content: str, valid_names: set[str]) -> list[ToolCall]:
    """Best-effort recovery of tool calls a model emitted as text instead of via
    Ollama's native tool_calls field.

    Only calls whose name matches a tool that was actually offered are returned,
    so ordinary JSON in a model's prose is not mistaken for a tool call.
    """
    if not content or not valid_names:
        return []

    blocks = _TOOL_CALL_TAG_RE.findall(content)
    if blocks:
        candidates = blocks
    else:
        stripped = _FENCE_RE.sub("", content).strip()
        try:
            whole = json.loads(stripped)
            candidates = (
                [json.dumps(x) for x in whole]
                if isinstance(whole, list)
                else [json.dumps(whole)]
            )
        except Exception:
            candidates = _JSON_OBJ_RE.findall(stripped)

    out: list[ToolCall] = []
    for c in candidates:
        try:
            obj = json.loads(c)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        fn = obj.get("function")
        if isinstance(fn, dict):
            name = obj.get("name") or fn.get("name")
            args = fn.get("arguments", obj.get("arguments", {}))
        else:
            name = obj.get("name") or obj.get("tool")
            args = obj.get("arguments", obj.get("parameters", {}))
        if name not in valid_names:
            continue
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        out.append(ToolCall(
            id=f"call_{uuid.uuid4().hex[:8]}",
            name=name,
            arguments=args if isinstance(args, dict) else {},
        ))
    return out


def _serialize_messages_for_ollama(messages) -> list[dict]:
    """Serialize Nova messages for Ollama /api/chat, preserving tool turns.

    Nova allows content to be str | list[ContentBlock]. Ollama expects str
    content on user/assistant/system, and role='tool' with stringified content
    for tool results. Tool-call emission (role='assistant' with tool_calls)
    must round-trip so multi-round tool loops keep context."""
    out: list[dict] = []
    for m in messages:
        raw_content = m.content
        # Flatten ContentBlock list to plain string for Ollama
        if isinstance(raw_content, list):
            parts: list[str] = []
            for b in raw_content:
                if hasattr(b, "text") and getattr(b, "text", None):
                    parts.append(b.text)
                elif isinstance(b, dict) and b.get("type") == "text":
                    parts.append(b.get("text", ""))
            content = "\n".join(p for p in parts if p)
        else:
            content = raw_content or ""
        msg_dict: dict = {"role": m.role, "content": content}
        if getattr(m, "tool_calls", None):
            msg_dict["tool_calls"] = [
                {
                    "id": tc.id,
                    "function": {"name": tc.name, "arguments": tc.arguments},
                }
                for tc in m.tool_calls
            ]
        if getattr(m, "tool_call_id", None):
            msg_dict["tool_call_id"] = m.tool_call_id
        out.append(msg_dict)
    return out


class OllamaProvider(ModelProvider):
    """
    Direct Ollama integration — OpenAI-compatible API at /api/chat.
    Includes health gating: a fast probe prevents 120s hangs when offline.
    """

    def __init__(self, base_url: str = settings.ollama_base_url, default_model: str = "llama3.2"):
        self._base_url = base_url
        self._default_model = default_model
        # Health state
        self._healthy: bool = False  # conservative — verify before reporting online
        self._last_health_check: float = 0.0
        self._wol_sent_at: float = 0.0
        self._health_lock = asyncio.Lock()

    async def _get_base_url(self) -> str:
        """Get the current Ollama base URL (runtime-configurable via dashboard)."""
        from app.registry import get_ollama_base_url
        url = await get_ollama_base_url()
        if url != self._base_url:
            log.info("Ollama base URL changed: %s -> %s", self._base_url, url)
            self._base_url = url
            self._healthy = True  # reset health for new URL
            self._last_health_check = 0.0
        return url

    @property
    def name(self) -> str:
        return "ollama"

    @property
    def capabilities(self) -> set[ModelCapability]:
        return {
            ModelCapability.chat,
            ModelCapability.streaming,
            ModelCapability.embeddings,
            ModelCapability.function_calling,
        }

    @property
    def is_local(self) -> bool:
        return True

    @property
    def healthy(self) -> bool:
        """Current cached health status."""
        return self._healthy

    async def _ensure_healthy(self) -> None:
        """
        Fast health gate: check if Ollama is reachable before sending real requests.
        Caches result for ollama_health_check_interval seconds.
        On failure, fires WoL in the background and raises RuntimeError.
        """
        base_url = await self._get_base_url()
        now = time.monotonic()
        if self._healthy and (now - self._last_health_check) < settings.ollama_health_check_interval:
            return  # recently checked and healthy — 0ms overhead

        async with self._health_lock:
            # Re-check after acquiring lock (another coroutine may have updated)
            now = time.monotonic()
            if self._healthy and (now - self._last_health_check) < settings.ollama_health_check_interval:
                return

            try:
                async with httpx.AsyncClient(
                    base_url=base_url,
                    timeout=settings.ollama_health_check_timeout,
                ) as client:
                    r = await client.get("/api/tags")
                    r.raise_for_status()
                self._healthy = True
                self._last_health_check = now
                return
            except Exception as e:
                self._healthy = False
                self._last_health_check = now
                log.warning("Ollama unreachable at %s: %s", base_url, e)

                # Fire WoL if configured and not recently sent
                from app.registry import get_wol_broadcast, get_wol_mac
                wol_mac = await get_wol_mac()
                if wol_mac and (now - self._wol_sent_at) > settings.wol_boot_wait_seconds:
                    self._wol_sent_at = now
                    wol_broadcast = await get_wol_broadcast()
                    from app.wol import send_wol
                    asyncio.create_task(send_wol(wol_mac, wol_broadcast))
                    log.info("WoL packet sent to %s (broadcast %s)", wol_mac, wol_broadcast)

                raise RuntimeError(
                    f"Local inference unreachable: Ollama did not respond at {base_url}. "
                    f"Check that the backend is running and that inference.url / "
                    f"OLLAMA_BASE_URL points at a reachable host. Note: from inside this "
                    f"container 'localhost' is the container itself — use the compose "
                    f"service name (http://ollama:11434) or http://host.docker.internal:11434."
                ) from e

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        await self._ensure_healthy()
        messages = _serialize_messages_for_ollama(request.messages)
        body = {
            "model": request.model or self._default_model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": request.temperature},
        }
        if request.tools:
            body["tools"] = [_tool_to_ollama(t) for t in request.tools]
        from app.registry import get_ollama_keep_alive
        keep_alive = await get_ollama_keep_alive()
        if keep_alive:
            body["keep_alive"] = keep_alive

        async with httpx.AsyncClient(base_url=self._base_url, timeout=settings.ollama_request_timeout) as client:
            resp = await client.post("/api/chat", json=body)
            resp.raise_for_status()
            data = resp.json()

        msg = data.get("message", {})
        content = msg.get("content", "") or ""
        tool_calls = _parse_ollama_tool_calls(msg.get("tool_calls", []))
        # Fallback: recover tool calls emitted as text by models whose Ollama
        # template lacks native tool support, so the agent acts instead of
        # narrating the call it meant to make.
        if not tool_calls and request.tools:
            recovered = _extract_text_tool_calls(content, {t.name for t in request.tools})
            if recovered:
                log.info("Recovered %d text-emitted tool call(s) from content", len(recovered))
                tool_calls = recovered
                content = ""  # the text WAS the tool call, not a user-facing answer
        finish_reason = "tool_calls" if tool_calls else "stop"

        return CompleteResponse(
            content=content,
            model=data.get("model", request.model),
            tool_calls=tool_calls,
            input_tokens=data.get("prompt_eval_count", 0),
            output_tokens=data.get("eval_count", 0),
            cost_usd=None,  # local inference is free
            finish_reason=finish_reason,
        )

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        await self._ensure_healthy()
        messages = _serialize_messages_for_ollama(request.messages)
        body = {
            "model": request.model or self._default_model,
            "messages": messages,
            "stream": True,
            "options": {"temperature": request.temperature},
        }
        if request.tools:
            body["tools"] = [_tool_to_ollama(t) for t in request.tools]
        from app.registry import get_ollama_keep_alive
        keep_alive = await get_ollama_keep_alive()
        if keep_alive:
            body["keep_alive"] = keep_alive

        async with httpx.AsyncClient(base_url=self._base_url, timeout=settings.ollama_request_timeout) as client:
            async with client.stream("POST", "/api/chat", json=body) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    msg = chunk.get("message", {}) or {}
                    content = msg.get("content", "") or ""
                    done = chunk.get("done", False)
                    # Ollama emits tool_calls on the final chunk when the model
                    # decides to invoke tools — pass them through verbatim.
                    tool_calls = _parse_ollama_tool_calls(msg.get("tool_calls", []))

                    input_tokens = None
                    output_tokens = None
                    finish_reason = None
                    if done:
                        input_tokens = chunk.get("prompt_eval_count")
                        output_tokens = chunk.get("eval_count")
                        finish_reason = "tool_calls" if tool_calls else "stop"

                    yield StreamChunk(
                        delta=content,
                        finish_reason=finish_reason,
                        tool_calls=tool_calls,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                    )

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        await self._ensure_healthy()
        from app.registry import get_ollama_keep_alive
        keep_alive = await get_ollama_keep_alive()
        body: dict = {
            "model": request.model or self._default_model,
            "input": request.texts,
        }
        if keep_alive:
            body["keep_alive"] = keep_alive
        async with httpx.AsyncClient(base_url=self._base_url, timeout=settings.ollama_request_timeout) as client:
            resp = await client.post("/api/embed", json=body)
            resp.raise_for_status()
            data = resp.json()

        return EmbedResponse(
            embeddings=data["embeddings"],
            model=request.model,
            input_tokens=0,  # Ollama doesn't report token counts for embeddings
        )
