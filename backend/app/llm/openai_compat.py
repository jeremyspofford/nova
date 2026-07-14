"""Streaming client for OpenAI-compatible chat APIs (OpenRouter, Ollama /v1).

Event vocabulary yielded by stream():
    {"type": "text", "text": str}                    incremental content delta
    {"type": "tool_calls", "tool_calls": [           complete calls, end of turn
        {"id": str, "name": str, "arguments": str}]}
    {"type": "done"}
    {"type": "error", "error": str}
"""

import json
import logging
from typing import AsyncIterator, Optional

import httpx

log = logging.getLogger(__name__)


class OpenAICompatClient:
    def __init__(self, base_url: str, api_key: str = "", extra_headers: Optional[dict] = None,
                 timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.extra_headers = extra_headers or {}
        self.timeout = timeout

    async def stream(self, messages: list, model: str,
                     tools: Optional[list] = None) -> AsyncIterator[dict]:
        headers = {"Content-Type": "application/json", **self.extra_headers}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload: dict = {"model": model, "messages": messages, "stream": True}
        if tools:
            payload["tools"] = tools

        # Tool-call deltas arrive fragmented; merge them by choice index.
        pending_calls: dict[int, dict] = {}

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream("POST", f"{self.base_url}/chat/completions",
                                         json=payload, headers=headers) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode(errors="replace")[:500]
                        log.error("LLM API %s from %s: %s", resp.status_code, self.base_url, body)
                        yield {"type": "error",
                               "error": f"LLM API error {resp.status_code}: {body}"}
                        return

                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            log.warning("Unparseable stream chunk: %.200s", data)
                            continue

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}

                        content = delta.get("content")
                        if content:
                            yield {"type": "text", "text": content}

                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            slot = pending_calls.setdefault(
                                idx, {"id": "", "name": "", "arguments": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]

        except httpx.HTTPError as e:
            log.error("LLM connection error to %s: %s", self.base_url, e)
            yield {"type": "error", "error": f"LLM connection error: {e}"}
            return

        if pending_calls:
            calls = [pending_calls[i] for i in sorted(pending_calls)]
            # Synthesize ids if the provider omitted them (some local servers do)
            for n, c in enumerate(calls):
                c["id"] = c["id"] or f"call_{n}"
            yield {"type": "tool_calls", "tool_calls": calls}

        yield {"type": "done"}
