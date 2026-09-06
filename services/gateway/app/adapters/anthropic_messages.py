"""The `anthropic-messages` adapter: Anthropic's native Messages API,
translated to and from the OpenAI Chat Completions shape core speaks.

Why translate instead of using Anthropic's OpenAI-compatible layer: they
state it is "not production-ready" (no caching, tool schemas ignored). The
Messages API wire shapes below were verified against the live docs on
2026-09-05 (slice plan, frontier facts):

  request   POST {base}/v1/messages, x-api-key + anthropic-version;
            max_tokens REQUIRED; `system` top-level; tools carry
            input_schema; assistant tool calls are tool_use blocks
            {id, name, input}; results go back as tool_result blocks
            {tool_use_id, content} inside ONE user message.
  stream    message_start → content_block_start (text | tool_use)
            → content_block_delta (text_delta | input_json_delta)
            → content_block_stop → message_delta (stop_reason, usage)
            → message_stop; plus ping and error events.
  listing   GET {base}/v1/models?limit=…, paged by has_more/last_id.

Nothing here retries, falls back, or rephrases a refusal: a non-2xx is
relayed with Anthropic's own status and message in the OpenAI error shape.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field

import httpx
from fastapi import Request
from fastapi.responses import Response, StreamingResponse

from app.adapters import base
from app.adapters.base import (
    COMPLETIONS_TIMEOUT,
    MODELS_TIMEOUT,
    Listing,
    ListingUnavailable,
    ProviderRefused,
    VerifyResult,
    http_client,
    reason,
    refusal_detail,
)
from app.adapters.openai_chat import sse_error_chunk
from app.providers import base_url_of

logger = logging.getLogger("gateway")

ANTHROPIC_VERSION = "2023-06-01"
# Anthropic requires max_tokens; a caller that names none gets a ceiling
# that does not truncate a real answer mid-thought (the SDKs' own
# non-streaming default), never a lowball.
DEFAULT_MAX_TOKENS = 16000
LISTING_PAGE = 1000

_FINISH_REASONS = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "refusal": "content_filter",
    "pause_turn": "stop",
}


# ── request: OpenAI chat → Anthropic messages ─────────────────────────────


def _text_of(content: object) -> str:
    """The text of an OpenAI message `content`, whether a string or a list
    of parts. Non-text parts (image_url, audio) are dropped — this adapter
    carries text and tools; media is later work and is said so in the
    translation note rather than silently mangled."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text" and part.get("text"):
                parts.append(str(part["text"]))
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    if content is None:
        return ""
    return str(content)


def _tool_input(arguments: object) -> dict:
    """An OpenAI call's `arguments` (a JSON string) as the object Anthropic
    wants. Unparsable text is carried under `_raw` rather than dropped —
    the model wrote it, the record keeps it."""
    if isinstance(arguments, dict):
        return arguments
    if not isinstance(arguments, str) or not arguments.strip():
        return {}
    try:
        parsed = json.loads(arguments)
    except json.JSONDecodeError:
        return {"_raw": arguments}
    return parsed if isinstance(parsed, dict) else {"_value": parsed}


def _tool_result_content(content: object) -> str:
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    try:
        return json.dumps(content)
    except (TypeError, ValueError):
        return str(content)


@dataclass
class Translation:
    body: dict
    notes: list[str] = field(default_factory=list)


def to_messages_request(body: dict, model: str) -> Translation:
    """The Messages API request for an OpenAI chat-completions `body`."""
    notes: list[str] = []
    system_parts: list[str] = []
    messages: list[dict] = []
    pending_results: list[dict] = []

    def flush_results() -> None:
        if pending_results:
            messages.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for message in body.get("messages") or []:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role in ("system", "developer"):
            text = _text_of(message.get("content"))
            if text:
                system_parts.append(text)
            continue
        if role == "tool":
            pending_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": str(message.get("tool_call_id") or ""),
                    "content": _tool_result_content(message.get("content")),
                }
            )
            continue
        flush_results()
        if role == "assistant":
            blocks: list[dict] = []
            text = _text_of(message.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                function = call.get("function") or {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "input": _tool_input(function.get("arguments")),
                    }
                )
            if not blocks:
                # Anthropic rejects an empty assistant turn outright; an
                # empty one carries nothing worth sending anyway.
                notes.append("dropped an empty assistant message")
                continue
            messages.append({"role": "assistant", "content": blocks})
            continue
        # user (and anything unrecognised is carried as user text)
        content = message.get("content")
        if isinstance(content, list) and any(
            isinstance(p, dict) and p.get("type") not in (None, "text") for p in content
        ):
            notes.append("non-text content parts were dropped")
        messages.append({"role": "user", "content": _text_of(content) or " "})
    flush_results()

    request: dict = {
        "model": model,
        "messages": messages,
        "max_tokens": int(
            body.get("max_tokens") or body.get("max_completion_tokens") or DEFAULT_MAX_TOKENS
        ),
        "stream": bool(body.get("stream")),
    }
    if system_parts:
        request["system"] = "\n\n".join(system_parts)

    tools = body.get("tools")
    if isinstance(tools, list) and tools:
        translated = []
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            function = tool.get("function") if tool.get("type") == "function" else tool
            if not isinstance(function, dict) or not function.get("name"):
                continue
            entry = {
                "name": str(function["name"]),
                "input_schema": function.get("parameters")
                or {"type": "object", "properties": {}},
            }
            if function.get("description"):
                entry["description"] = str(function["description"])
            translated.append(entry)
        if translated:
            request["tools"] = translated

    choice = body.get("tool_choice")
    if choice == "auto":
        request["tool_choice"] = {"type": "auto"}
    elif choice == "none":
        request["tool_choice"] = {"type": "none"}
    elif choice is not None:
        # `required` / a named function = Anthropic's `any`/`tool`, which
        # current models reject outright — left to `auto` and said so.
        notes.append(f"tool_choice {choice!r} is not forced on this adapter")

    for key in ("temperature", "top_p", "top_k"):
        if key in body and body[key] is not None:
            request[key] = body[key]
    stop = body.get("stop")
    if isinstance(stop, str):
        request["stop_sequences"] = [stop]
    elif isinstance(stop, list) and stop:
        request["stop_sequences"] = [str(s) for s in stop]
    return Translation(body=request, notes=notes)


# ── response: Anthropic → OpenAI ──────────────────────────────────────────


def _usage(input_tokens: int | None, output_tokens: int | None) -> dict:
    usage: dict = {}
    if input_tokens is not None:
        usage["prompt_tokens"] = input_tokens
    if output_tokens is not None:
        usage["completion_tokens"] = output_tokens
    if input_tokens is not None and output_tokens is not None:
        usage["total_tokens"] = input_tokens + output_tokens
    return usage


def _chunk(msg_id: str, model: str, delta: dict, finish_reason: str | None = None) -> bytes:
    payload = {
        "id": msg_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(payload)}\n\n".encode()


class StreamTranslator:
    """Anthropic SSE events in, OpenAI chat-completion chunks out.

    Fed one parsed `data:` JSON object at a time; `events()` returns the
    bytes to emit for it. Tool calls get OpenAI's per-call `index` (the
    order the tool_use blocks started), which is what core's ToolCallBuffer
    keys on, and every argument fragment repeats that index.
    """

    def __init__(self, model: str) -> None:
        self.model = model
        self.msg_id = ""
        self.input_tokens: int | None = None
        self.output_tokens: int | None = None
        self._tool_index_by_block: dict[int, int] = {}
        self._tool_count = 0
        self.finished = False
        self.saw_message_stop = False

    def feed(self, event: dict) -> list[bytes]:
        kind = event.get("type")
        out: list[bytes] = []
        if kind == "message_start":
            message = event.get("message") or {}
            self.msg_id = str(message.get("id") or "")
            self.model = str(message.get("model") or self.model)
            usage = message.get("usage") or {}
            if isinstance(usage.get("input_tokens"), int):
                self.input_tokens = usage["input_tokens"]
            if isinstance(usage.get("output_tokens"), int):
                self.output_tokens = usage["output_tokens"]
            out.append(_chunk(self.msg_id, self.model, {"role": "assistant", "content": ""}))
        elif kind == "content_block_start":
            block = event.get("content_block") or {}
            if block.get("type") == "tool_use":
                index = self._tool_count
                self._tool_count += 1
                self._tool_index_by_block[int(event.get("index", 0))] = index
                out.append(
                    _chunk(
                        self.msg_id,
                        self.model,
                        {
                            "tool_calls": [
                                {
                                    "index": index,
                                    "id": str(block.get("id") or ""),
                                    "type": "function",
                                    "function": {
                                        "name": str(block.get("name") or ""),
                                        "arguments": "",
                                    },
                                }
                            ]
                        },
                    )
                )
        elif kind == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta":
                text = delta.get("text")
                if text:
                    out.append(_chunk(self.msg_id, self.model, {"content": text}))
            elif delta.get("type") == "input_json_delta":
                partial = delta.get("partial_json")
                block_index = int(event.get("index", 0))
                index = self._tool_index_by_block.get(block_index)
                if partial and index is not None:
                    out.append(
                        _chunk(
                            self.msg_id,
                            self.model,
                            {
                                "tool_calls": [
                                    {"index": index, "function": {"arguments": partial}}
                                ]
                            },
                        )
                    )
        elif kind == "message_delta":
            usage = event.get("usage") or {}
            if isinstance(usage.get("output_tokens"), int):
                self.output_tokens = usage["output_tokens"]
            if isinstance(usage.get("input_tokens"), int):
                self.input_tokens = usage["input_tokens"]
            stop = (event.get("delta") or {}).get("stop_reason")
            if stop:
                finish = _FINISH_REASONS.get(str(stop), "stop")
                out.append(_chunk(self.msg_id, self.model, {}, finish_reason=finish))
                self.finished = True
        elif kind == "message_stop":
            self.saw_message_stop = True
            usage = _usage(self.input_tokens, self.output_tokens)
            if usage:
                payload = {
                    "id": self.msg_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": self.model,
                    "choices": [],
                    "usage": usage,
                }
                out.append(f"data: {json.dumps(payload)}\n\n".encode())
            out.append(b"data: [DONE]\n\n")
        elif kind == "error":
            err = event.get("error") or {}
            message = err.get("message") or "unspecified error"
            err_type = err.get("type")
            stated = f"{err_type}: {message}" if err_type else str(message)
            out.append(sse_error_chunk(f"anthropic reported an error — {stated}"))
            self.finished = True
        # ping, content_block_stop: nothing to say
        return out


def to_chat_completion(message: dict, model: str) -> dict:
    """A whole (non-streamed) Messages API response as an OpenAI
    chat.completion object."""
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for block in message.get("content") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and block.get("text"):
            text_parts.append(str(block["text"]))
        elif block.get("type") == "tool_use":
            tool_calls.append(
                {
                    "id": str(block.get("id") or ""),
                    "type": "function",
                    "function": {
                        "name": str(block.get("name") or ""),
                        "arguments": json.dumps(block.get("input") or {}),
                    },
                }
            )
    reply: dict = {"role": "assistant", "content": "".join(text_parts) or None}
    if tool_calls:
        reply["tool_calls"] = tool_calls
    usage = message.get("usage") or {}
    return {
        "id": str(message.get("id") or ""),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": str(message.get("model") or model),
        "choices": [
            {
                "index": 0,
                "message": reply,
                "finish_reason": _FINISH_REASONS.get(str(message.get("stop_reason")), "stop"),
            }
        ],
        "usage": _usage(
            usage.get("input_tokens") if isinstance(usage.get("input_tokens"), int) else None,
            usage.get("output_tokens") if isinstance(usage.get("output_tokens"), int) else None,
        ),
    }


def _error_body(resp: httpx.Response) -> bytes:
    """Anthropic's `{"type":"error","error":{type,message}}` as the OpenAI
    error shape core and the UI already read."""
    try:
        parsed = resp.json()
    except ValueError:
        parsed = None
    err = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(err, dict):
        message = err.get("message") or refusal_detail(resp)
        return json.dumps({"error": {"message": message, "type": err.get("type")}}).encode()
    return json.dumps({"error": {"message": refusal_detail(resp)}}).encode()


class AnthropicMessages:
    name = "anthropic-messages"

    def headers(self, row: dict) -> dict[str, str]:
        headers = base.bearer_or_header(row, header_name="x-api-key")
        headers["anthropic-version"] = ANTHROPIC_VERSION
        return headers

    async def list_models(self, app, row: dict) -> Listing:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        models: list[dict] = []
        after: str | None = None
        client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=self.headers(row))
        try:
            async with client as c:
                for _page in range(20):
                    params = {"limit": LISTING_PAGE}
                    if after:
                        params["after_id"] = after
                    resp = await c.get("/v1/models", params=params)
                    if resp.status_code in (404, 405):
                        raise ListingUnavailable(
                            f"{url}/v1/models answered {resp.status_code} — no model listing"
                        )
                    if resp.status_code != 200:
                        raise ProviderRefused(resp.status_code, refusal_detail(resp))
                    try:
                        body = resp.json()
                    except ValueError as exc:
                        raise ProviderRefused(
                            502, f"{url}/v1/models returned non-JSON: {exc}"
                        ) from exc
                    for entry in body.get("data") or []:
                        if isinstance(entry, dict) and entry.get("id"):
                            item: dict = {"id": str(entry["id"]), "owned_by": row["name"]}
                            if entry.get("display_name"):
                                item["name"] = str(entry["display_name"])
                            for key in ("max_input_tokens",):
                                if isinstance(entry.get(key), int):
                                    item["context_length"] = entry[key]
                            models.append(item)
                    if not body.get("has_more") or not body.get("last_id"):
                        break
                    after = str(body["last_id"])
        except httpx.HTTPError as exc:
            raise ProviderRefused(502, f"could not reach {url} — {reason(exc)}") from exc
        return Listing(source=row["name"], models=models)

    async def verify(self, app, row: dict) -> VerifyResult:
        try:
            listing = await self.list_models(app, row)
        except ListingUnavailable as exc:
            return VerifyResult(listing="unavailable", note=str(exc))
        return VerifyResult(listing="available", note=f"{len(listing.models)} models listed")

    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        translation = to_messages_request(body, model)
        if translation.notes:
            logger.info("anthropic translation notes: %s", "; ".join(translation.notes))
        streaming = translation.body["stream"]
        client = http_client(
            request.app, COMPLETIONS_TIMEOUT, base_url=url, headers=self.headers(row)
        )
        try:
            upstream = await client.send(
                client.build_request("POST", "/v1/messages", json=translation.body),
                stream=True,
            )
        except httpx.HTTPError as exc:
            await client.aclose()
            raise ProviderRefused(
                502, f"could not reach {row['name']} at {url} — {reason(exc)}"
            ) from exc

        if upstream.status_code != 200:
            await upstream.aread()
            content = _error_body(upstream)
            status = upstream.status_code
            await upstream.aclose()
            await client.aclose()
            return Response(content=content, status_code=status, media_type="application/json")

        if not streaming:
            raw = await upstream.aread()
            await upstream.aclose()
            await client.aclose()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ProviderRefused(502, f"anthropic returned a non-JSON message: {exc}") from exc
            return Response(
                content=json.dumps(to_chat_completion(message, model)).encode(),
                media_type="application/json",
            )

        translator = StreamTranslator(model)

        async def relay():
            try:
                async for line in upstream.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if not data:
                        continue
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    for chunk in translator.feed(event):
                        yield chunk
                    if translator.saw_message_stop:
                        return
                    if translator.finished and (event.get("type") == "error"):
                        return
                if not translator.saw_message_stop:
                    # The upstream ended without message_stop: say so in the
                    # stream rather than end as if it had finished cleanly.
                    yield sse_error_chunk(
                        "the anthropic stream ended before message_stop — the reply may be "
                        "incomplete"
                    )
            except httpx.HTTPError as exc:
                failure = reason(exc)
                logger.warning("anthropic stream failed mid-flight: %s", failure)
                yield sse_error_chunk(f"the {row['name']} stream failed — {failure}")
            finally:
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(relay(), status_code=200, media_type="text/event-stream")


ADAPTER = AnthropicMessages()
