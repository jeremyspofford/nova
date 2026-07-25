"""Ollama's own /api/chat, for the two controls its OpenAI-compat endpoint
does not expose.

Nova talks OpenAI-compat to everything, including ollama, and that stays
true for every model this file does not serve. But two things a local model
needs are simply absent from /v1, measured 2026-07-24 on ollama 0.31.2:

  * `think` is IGNORED there. Sending think:false to /v1 still returned 889
    characters of reasoning; the same request to /api/chat returned zero.
    Shipping the operator's thinking toggle on /v1 would have been a silent
    no-op — the setting would move and nothing would happen.
  * `options.num_ctx` is likewise ignored (turn-speed phase 3), so the
    context window a local call runs at could only be set server-wide.

Same event vocabulary as OpenAICompatClient, deliberately — the runner
cannot tell which client it is talking to. The translation work all lives
here, in one direction:

  * ollama returns tool-call arguments as an OBJECT; OpenAI (and Nova's
    runner, which json.loads them) uses a JSON STRING. Converted both ways.
  * multimodal content is a list of parts on the OpenAI side and a separate
    `images` array of raw base64 on ollama's. Converted, so a local vision
    model still sees the picture.
  * token counts arrive once, on the final chunk, as prompt_eval_count /
    eval_count.
"""

import json
import logging
from typing import AsyncIterator, Optional

import httpx

log = logging.getLogger(__name__)


def _split_image_parts(content) -> tuple[str, list[str]]:
    """OpenAI list-content -> (text, [base64 image, ...]).

    A data: URL carries its payload after the comma; anything else is a
    remote URL, which ollama cannot fetch for us, so it is dropped rather
    than sent as a string the model would read as text.
    """
    if isinstance(content, str) or content is None:
        return (content or ""), []
    text_parts: list[str] = []
    images: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            text_parts.append(part.get("text") or "")
        elif part.get("type") == "image_url":
            url = ((part.get("image_url") or {}).get("url") or "")
            if url.startswith("data:") and "," in url:
                images.append(url.split(",", 1)[1])
            else:
                log.warning("dropping non-data image URL for a local model")
    return "\n".join(p for p in text_parts if p), images


def to_ollama_messages(messages: list) -> list[dict]:
    """OpenAI-shaped messages -> ollama-shaped, losing nothing it can use."""
    out: list[dict] = []
    for m in messages:
        text, images = _split_image_parts(m.get("content"))
        msg: dict = {"role": m.get("role", "user"), "content": text}
        if images:
            msg["images"] = images
        calls = m.get("tool_calls")
        if calls:
            converted = []
            for call in calls:
                fn = call.get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args) if args else {}
                    except json.JSONDecodeError:
                        # keep the malformed text visible to the model rather
                        # than inventing {} — the runner's malformed-args rail
                        # depends on bad arguments staying bad
                        args = {"_raw": args}
                converted.append({"function": {"name": fn.get("name") or "",
                                               "arguments": args or {}}})
            msg["tool_calls"] = converted
        # ollama pairs tool results positionally and names the tool rather
        # than echoing an id; carry the name when we know it
        if m.get("role") == "tool" and m.get("name"):
            msg["tool_name"] = m["name"]
        out.append(msg)
    return out


class OllamaNativeClient:
    def __init__(self, base_url: str, timeout: float = 300.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def stream(self, messages: list, model: str,
                     tools: Optional[list] = None,
                     include_usage: bool = True,
                     think: Optional[bool] = None,
                     num_ctx: Optional[int] = None) -> AsyncIterator[dict]:
        payload: dict = {"model": model, "messages": to_ollama_messages(messages),
                         "stream": True}
        if tools:
            payload["tools"] = tools
        if think is not None:
            payload["think"] = think
        if num_ctx:
            payload["options"] = {"num_ctx": int(num_ctx)}

        produced_output = False
        pending_calls: list[dict] = []

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream("POST", f"{self.base_url}/api/chat",
                                         json=payload) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode(errors="replace")[:500]
                        log.error("ollama %s: %s", resp.status_code, body)
                        hint = ("" if resp.status_code != 404 else
                                f" — '{model}' is not pulled on this server")
                        yield {"type": "error",
                               "error": f"Ollama error {resp.status_code}: {body}{hint}",
                               "error_class": "http_status",
                               "status_code": resp.status_code}
                        return

                    async for line in resp.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            log.warning("unparseable ollama chunk: %.200s", line)
                            continue
                        if chunk.get("error"):
                            klass = "mid_stream" if produced_output else "connect_failed"
                            yield {"type": "error",
                                   "error": str(chunk["error"]),
                                   "error_class": klass, "status_code": None}
                            return

                        message = chunk.get("message") or {}
                        thinking = message.get("thinking")
                        if thinking:
                            # not `text`: never spoken, never the answer
                            yield {"type": "reasoning", "text": thinking}
                        content = message.get("content")
                        if content:
                            produced_output = True
                            yield {"type": "text", "text": content}
                        for call in message.get("tool_calls") or []:
                            produced_output = True
                            fn = call.get("function") or {}
                            args = fn.get("arguments")
                            pending_calls.append({
                                "id": call.get("id") or f"call_{len(pending_calls)}",
                                "name": fn.get("name") or "",
                                # back to the JSON STRING the runner parses
                                "arguments": (args if isinstance(args, str)
                                              else json.dumps(args or {})),
                            })

                        if chunk.get("done"):
                            if include_usage:
                                yield {"type": "usage", "usage": {
                                    "prompt_tokens": chunk.get("prompt_eval_count"),
                                    "completion_tokens": chunk.get("eval_count"),
                                }}
                            break
        except httpx.HTTPError as e:
            klass = "mid_stream" if produced_output else "connect_failed"
            log.error("ollama %s error: %s", klass, e)
            yield {"type": "error",
                   "error": (f"Ollama connection error: {e}" if not produced_output
                             else f"Ollama stream failed mid-answer: {e}"),
                   "error_class": klass, "status_code": None}
            return

        if pending_calls:
            yield {"type": "tool_calls", "tool_calls": pending_calls}
        yield {"type": "done"}
