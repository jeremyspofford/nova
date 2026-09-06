"""The `anthropic-messages` adapter: Anthropic's native Messages API,
translated to and from the OpenAI Chat Completions shape core speaks.

Why translate instead of using Anthropic's OpenAI-compatible layer: they
state it is "not production-ready" (no caching, tool schemas ignored). The
Messages API wire shapes below were verified against the live docs on
2026-09-05 (slice plan, frontier facts):

  request   POST {base}/messages (base_url INCLUDES the version path, e.g.
            https://api.anthropic.com/v1 — the same convention as every
            other adapter), x-api-key + anthropic-version;
            max_tokens REQUIRED; `system` top-level; tools carry
            input_schema; assistant tool calls are tool_use blocks
            {id, name, input}; results go back as tool_result blocks
            {tool_use_id, content} inside ONE user message.
  stream    message_start → content_block_start (text | tool_use)
            → content_block_delta (text_delta | input_json_delta)
            → content_block_stop → message_delta (stop_reason, usage)
            → message_stop; plus ping and error events.
  listing   GET {base}/models?limit=…, paged by has_more/last_id; each
            row's `max_tokens` (its output cap) is remembered so a
            completion never asks for more than the model can give.

The request is NORMALISED before it leaves (see normalize_messages): the
API rejects a first message that is not `user`, rejects an empty messages
array, and pairs every tool_result with an earlier tool_use — core's
history window can hand us any of those shapes (a window that starts on an
assistant row is the common one), so they are fixed here, and what was
changed is said in the translation notes.

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

# (provider name, model id) -> the model's output cap, as its /models row
# stated it. Filled by list_models; read by completions to clamp
# max_tokens. Process-local and DERIVED from the listing — never a table.
_OUTPUT_CAPS: dict[tuple[str, str], int] = {}


def output_cap(provider: str, model: str) -> int | None:
    return _OUTPUT_CAPS.get((provider, model))


# Which sub-object of a GET /v1/models row's `capabilities` states which
# catalogue capability (live shape, verified 2026-09-06: image_input,
# pdf_input, thinking{supported, types}, effort, structured_outputs, each
# with a `supported` bool). Tools is NOT in the listing — no field states
# it — so it is never emitted here: "not stated" is the truth, and a "no"
# would be a guess.
_LISTED_CAPABILITIES = (
    ("vision", "image_input"),
    ("thinking", "thinking"),
    ("pdf", "pdf_input"),
    ("structured_outputs", "structured_outputs"),
)


def declared_capabilities(capabilities: object) -> dict:
    """The catalogue's capability entries a listing row's `capabilities`
    object states, `{value: bool, basis: declared, source: provider-
    listing}` each. Only keys whose `supported` is a real bool appear: a
    stated `false` is a fact, a missing sub-object is not."""
    out: dict = {}
    if not isinstance(capabilities, dict):
        return out
    for key, field_name in _LISTED_CAPABILITIES:
        sub = capabilities.get(field_name)
        if isinstance(sub, dict) and isinstance(sub.get("supported"), bool):
            out[key] = {
                "value": sub["supported"],
                "basis": "declared",
                "source": "provider-listing",
            }
    return out


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


def _blocks(content: object) -> list[dict]:
    if isinstance(content, list):
        return list(content)
    return [{"type": "text", "text": str(content)}]


def normalize_messages(messages: list[dict], notes: list[str]) -> list[dict]:
    """The three invariants the Messages API enforces, made true here.

    1. A `tool_result` must answer a `tool_use` the request itself carries.
       An orphan (its call was in a row core's history window cut off, or a
       result arrived before any call) is carried as plain text — the
       content is kept, the pairing claim is not.
    2. The first message is `user`: leading assistant rows (a history
       window that opens on a reply) are dropped, and said.
    3. Roles alternate: consecutive same-role messages are merged into one
       message whose content is the concatenated blocks.
    An empty result is a ProviderRefused(400) — a request that is certain
    to be refused is never sent.
    """
    seen_tool_use: set[str] = set()
    fixed: list[dict] = []
    for message in messages:
        role = message["role"]
        content = message["content"]
        if role == "assistant" and isinstance(content, list):
            seen_tool_use.update(
                str(block.get("id")) for block in content if block.get("type") == "tool_use"
            )
        if role == "user" and isinstance(content, list):
            kept = []
            for block in content:
                orphan = block.get("tool_use_id") not in seen_tool_use
                if block.get("type") == "tool_result" and orphan:
                    notes.append(
                        f"tool_result {block.get('tool_use_id')!r} has no tool_use in this "
                        "request — carried as text"
                    )
                    kept.append(
                        {
                            "type": "text",
                            "text": "[result of an earlier tool call]\n"
                            + str(block.get("content") or ""),
                        }
                    )
                else:
                    kept.append(block)
            content = kept
        if not fixed and role != "user":
            notes.append("dropped a leading assistant message — the first message must be user")
            continue
        if fixed and fixed[-1]["role"] == role:
            merged = _blocks(fixed[-1]["content"]) + _blocks(content)
            fixed[-1] = {"role": role, "content": merged}
            notes.append(f"merged consecutive {role} messages")
            continue
        fixed.append({"role": role, "content": content})
    if not fixed:
        raise ProviderRefused(
            400, "nothing to send — the conversation has no user message after normalisation"
        )
    return fixed


def to_messages_request(
    body: dict, model: str, *, output_cap: int | None = None
) -> Translation:
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

    messages = normalize_messages(messages, notes)
    max_tokens = int(
        body.get("max_tokens") or body.get("max_completion_tokens") or DEFAULT_MAX_TOKENS
    )
    if output_cap is not None and max_tokens > output_cap:
        notes.append(f"max_tokens {max_tokens} clamped to the model's stated cap {output_cap}")
        max_tokens = output_cap
    request: dict = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
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

    # Sampling controls are REMOVED on current Claude models (a 400, not a
    # warning). Core never sends them; a caller that does gets a note on the
    # span, not a refused turn.
    dropped = [key for key in ("temperature", "top_p", "top_k") if body.get(key) is not None]
    if dropped:
        notes.append(
            "dropped sampling parameters not accepted by current models: " + ", ".join(dropped)
        )
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
                    resp = await c.get("/models", params=params)
                    if resp.status_code in (404, 405):
                        raise ListingUnavailable(
                            f"{url}/models answered {resp.status_code} — no model listing"
                        )
                    if resp.status_code != 200:
                        raise ProviderRefused(resp.status_code, refusal_detail(resp))
                    try:
                        body = resp.json()
                    except ValueError as exc:
                        raise ProviderRefused(
                            502, f"{url}/models returned non-JSON: {exc}"
                        ) from exc
                    for entry in body.get("data") or []:
                        if isinstance(entry, dict) and entry.get("id"):
                            item: dict = {"id": str(entry["id"]), "owned_by": row["name"]}
                            if entry.get("display_name"):
                                item["name"] = str(entry["display_name"])
                            if isinstance(entry.get("max_input_tokens"), int):
                                item["context_length"] = entry["max_input_tokens"]
                            if isinstance(entry.get("max_tokens"), int) and entry["max_tokens"] > 0:
                                item["max_output_tokens"] = entry["max_tokens"]
                                _OUTPUT_CAPS[(row["name"], item["id"])] = entry["max_tokens"]
                            declared = declared_capabilities(entry.get("capabilities"))
                            if declared:
                                item["capabilities_declared"] = declared
                            models.append(item)
                    if not body.get("has_more") or not body.get("last_id"):
                        break
                    after = str(body["last_id"])
                else:
                    raise ProviderRefused(
                        502,
                        f"{url}/models kept paging past {20 * LISTING_PAGE} rows — refusing to "
                        "report a partial list as complete",
                    )
        except httpx.HTTPError as exc:
            raise ProviderRefused(502, f"could not reach {url} — {reason(exc)}") from exc
        return Listing(source=row["name"], models=models)

    async def verify(self, app, row: dict) -> VerifyResult:
        try:
            listing = await self.list_models(app, row)
        except ListingUnavailable as exc:
            return VerifyResult(
                listing="unavailable",
                note=f"{exc} — the key was not tested; the first chat turn will tell",
                key_proven=None,
            )
        note = f"{len(listing.models)} models listed"
        if not listing.models:
            return VerifyResult(
                listing="available",
                note=f"{note} — nothing to test the key on; the first chat turn will tell",
                key_proven=None,
            )
        # DERIVED, never assumed from the vendor's name: api.anthropic.com's
        # /v1/models is behind x-api-key, but this adapter takes any base URL
        # (a proxy's listing may be public). Re-ask with a wrong key.
        public, decided_by = await self._listing_is_public(app, row)
        if public is False:
            return VerifyResult(
                listing="available", note=f"{note}; the listing accepted the key", key_proven=True
            )
        if public is None:
            return VerifyResult(
                listing="available",
                note=f"{note}; whether the listing is public could not be determined — "
                f"{decided_by} — so the key is NOT proven; the first chat turn will tell",
                key_proven=None,
            )
        model = listing.models[0]["id"]
        status, words, completed = await self._key_probe(app, row, model)
        if status in (401, 403):
            raise ProviderRefused(status, f"the key was refused on a test message — {words}")
        if completed:
            return VerifyResult(
                listing="available",
                note=f"{note}; the listing is public, so the key was proven with a 1-token "
                f"message on {model}",
                key_proven=True,
            )
        return VerifyResult(
            listing="available",
            note=f"{note}; the listing is public and a 1-token test on {model} answered "
            f"{status} ({words}) — the key is NOT proven; the first chat turn will tell",
            key_proven=False,
        )

    async def _listing_is_public(self, app, row: dict) -> tuple[bool | None, str]:
        """Same three-valued check as openai-chat (see there): 401/403 to a
        wrong key = the listing requires the key; 200 = public; anything
        else decides nothing."""
        probe_row = dict(row, api_key="nova-verify-this-key-is-wrong")
        url = base_url_of(row)
        client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=self.headers(probe_row))
        try:
            async with client as c:
                resp = await c.get("/models", params={"limit": 1})
        except httpx.HTTPError as exc:
            return None, f"the wrong-key check could not reach {url}/models — {reason(exc)}"
        if resp.status_code == 200:
            return True, "the listing answered 200 to a wrong key"
        if resp.status_code in (401, 403):
            return False, f"the listing refused a wrong key ({resp.status_code})"
        return None, f"the wrong-key check answered {resp.status_code} ({refusal_detail(resp)})"

    async def _key_probe(self, app, row: dict, model: str) -> tuple[int, str, bool]:
        """A 1-token message through the SAME translation a turn uses —
        (status, the provider's words, whether a completion came back)."""
        try:
            response = await self._completions_app(
                app,
                row,
                model,
                {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 1, "stream": False},
            )
        except ProviderRefused as exc:
            return exc.status, exc.detail, False
        content = b""
        iterator = getattr(response, "body_iterator", None)
        if iterator is not None:
            async for chunk in iterator:
                content += chunk if isinstance(chunk, bytes) else str(chunk).encode()
        else:
            content = response.body
        words = content.decode(errors="replace")[:400]
        completed = False
        if response.status_code == 200:
            try:
                parsed = json.loads(content)
            except ValueError:
                parsed = None
            completed = (
                isinstance(parsed, dict)
                and isinstance(parsed.get("choices"), list)
                and parsed.get("error") is None
            )
        return response.status_code, words, completed

    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        return await self._completions_app(request.app, row, model, body)

    async def _completions_app(self, app, row: dict, model: str, body: dict) -> Response:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        translation = to_messages_request(body, model, output_cap=output_cap(row["name"], model))
        if translation.notes:
            logger.info("anthropic translation notes: %s", "; ".join(translation.notes))
        streaming = translation.body["stream"]
        client = http_client(app, COMPLETIONS_TIMEOUT, base_url=url, headers=self.headers(row))
        try:
            upstream = await client.send(
                client.build_request("POST", "/messages", json=translation.body),
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
