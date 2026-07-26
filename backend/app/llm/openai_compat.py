"""Streaming client for OpenAI-compatible chat APIs (OpenRouter, Ollama /v1).

Event vocabulary yielded by stream():
    {"type": "text", "text": str}                    incremental content delta
    {"type": "tool_calls", "tool_calls": [           complete calls, end of turn
        {"id": str, "name": str, "arguments": str}]}
    {"type": "reasoning", "text": str}               a thinking model's scratchpad
    {"type": "usage", "usage": dict}                 only with include_usage
    {"type": "done"}
    {"type": "error", "error": str, "error_class": str, "status_code": int|None}

`error_class` is what makes a fallback decision safe (turn-speed phase 3).
One undifferentiated error string cannot tell "the local server isn't
running" from "the model died halfway through writing to memory", and those
demand opposite responses:

    connect_failed  nothing was sent or nothing came back — retrying
                    elsewhere is free and duplicates nothing
    http_status     the server answered with an error before any output;
                    404 specifically means the model is not pulled
    mid_stream      output had already started. NEVER auto-retry: the turn
                    may have executed tools, and a retry double-bills and
                    duplicates side effects. Surface it instead.
"""

import json
import logging
from typing import AsyncIterator, Optional

import httpx

from app import http as http_pool, redact

log = logging.getLogger(__name__)


class OpenAICompatClient:
    def __init__(self, base_url: str, api_key: str = "", extra_headers: Optional[dict] = None,
                 timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.extra_headers = extra_headers or {}
        self.timeout = timeout

    async def stream(self, messages: list, model: str,
                     tools: Optional[list] = None,
                     include_usage: bool = False,
                     think: Optional[bool] = None) -> AsyncIterator[dict]:
        headers = {"Content-Type": "application/json", **self.extra_headers}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload: dict = {"model": model, "messages": messages, "stream": True}
        if tools:
            payload["tools"] = tools
        if include_usage:  # exact token counts in a final usage chunk
            payload["stream_options"] = {"include_usage": True}
        if think is not None:
            # ollama's own extension, honored on this OpenAI-compatible
            # endpoint; servers that don't know it ignore an unknown field
            payload["think"] = think

        # Tool-call deltas arrive fragmented; merge them by choice index.
        pending_calls: dict[int, dict] = {}
        # once anything has been yielded, a failure is mid_stream and the
        # caller must not retry it anywhere
        produced_output = False

        try:
            # Shared pool, NOT a per-call client: this is the hottest
            # outbound path in the app and a fresh client meant a fresh TCP
            # + TLS handshake before every single LLM round, thrown away the
            # moment the round finished. Timeout stays per-request.
            client = http_pool.client()
            async with client.stream("POST", f"{self.base_url}/chat/completions",
                                     json=payload, headers=headers,
                                     timeout=self.timeout) as resp:
                if resp.status_code != 200:
                    # A provider 400 routinely ECHOES the offending request
                    # content, and on a tool round that content is the tool
                    # messages. This body reaches the browser, the span, the
                    # turn error, an automation summary, memory on disk, and
                    # an ntfy push — scrub it where it is born, once.
                    body = redact.scrub_text(
                        (await resp.aread()).decode(errors="replace"), 500)
                    log.error("LLM API %s from %s: %s", resp.status_code, self.base_url, body)
                    hint = ("" if resp.status_code != 404 else
                            f" — '{model}' is not available on this server "
                            f"(not pulled?)")
                    yield {"type": "error",
                           "error": f"LLM API error {resp.status_code}: {body}{hint}",
                           "error_class": "http_status",
                           "status_code": resp.status_code}
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

                    if chunk.get("usage"):
                        yield {"type": "usage", "usage": chunk["usage"]}
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}

                    content = delta.get("content")
                    if content:
                        produced_output = True
                        yield {"type": "text", "text": content}

                    # A reasoning model's scratchpad arrives on its own key.
                    # It is NOT text: text is the answer — spoken by TTS,
                    # shown in the bubble, persisted as the reply.
                    # Deliberately does not set produced_output: thinking
                    # alone has caused no side effect, so a stream that dies
                    # here is still safe to retry elsewhere.
                    reasoning = delta.get("reasoning")
                    if reasoning:
                        yield {"type": "reasoning", "text": reasoning}

                    for tc in delta.get("tool_calls") or []:
                        produced_output = True
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
            # the distinction that decides whether a fallback is safe: a
            # stream that already produced output may have executed tools
            klass = "mid_stream" if produced_output else "connect_failed"
            log.error("LLM %s error to %s: %s", klass, self.base_url, e)
            yield {"type": "error",
                   "error": (f"LLM connection error: {e}" if not produced_output
                             else f"LLM stream failed mid-answer: {e}"),
                   "error_class": klass, "status_code": None}
            return

        if pending_calls:
            calls = [pending_calls[i] for i in sorted(pending_calls)]
            # Synthesize ids if the provider omitted them (some local servers do)
            for n, c in enumerate(calls):
                c["id"] = c["id"] or f"call_{n}"
            yield {"type": "tool_calls", "tool_calls": calls}

        yield {"type": "done"}
