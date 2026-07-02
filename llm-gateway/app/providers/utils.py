"""
Shared provider utilities — DRY helpers used by multiple providers.
"""
from __future__ import annotations

import json as _json
import logging
import re
import uuid
from typing import Any

from nova_contracts import ToolCall

log = logging.getLogger(__name__)

# Standard: <tool_call> {json} </tool_call>
_TOOL_CALL_TAG_RE = re.compile(r"<\|?tool_call\|?>\s*(.*?)\s*<\|?/?tool_call\|?>", re.DOTALL)
_FENCE_RE = re.compile(r"```(?:json|tool_call)?", re.IGNORECASE)
# A JSON object allowing a single level of nesting (covers {"arguments": {...}}).
_JSON_OBJ_RE = re.compile(r"\{(?:[^{}]|\{[^{}]*\})*\}")
# Gemma / pseudo-syntax: call:name{key: "value", ...}  (unquoted keys, not JSON)
_CALL_SYNTAX_RE = re.compile(r"call:\s*(\w+)\s*\{(.*?)\}", re.DOTALL)
# key: "value" | key: 123 | key: true   pairs inside a pseudo-args block
_KV_RE = re.compile(r'(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)')


def _coerce_scalar(raw: str) -> Any:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"'):
        return raw[1:-1]
    low = raw.lower()
    if low in ("true", "false"):
        return low == "true"
    try:
        return int(raw)
    except ValueError:
        try:
            return float(raw)
        except ValueError:
            return raw


def extract_text_tool_calls(content: str, valid_names: set[str]) -> list[ToolCall]:
    """Best-effort recovery of tool calls a model emitted as text instead of via
    the server's structured tool_calls field.

    Handles three shapes seen from local models:
      1. <tool_call> {json} </tool_call>  and the <|tool_call> …<tool_call|> variant
      2. bare / fenced JSON objects with name+arguments
      3. Gemma-style  call:name{key: "value", …}  pseudo-syntax (unquoted keys)

    Only calls whose name matches an offered tool are returned, so ordinary
    JSON or prose is never mistaken for a tool call.
    """
    if not content or not valid_names:
        return []

    out: list[ToolCall] = []

    # 3. Gemma call:name{...} pseudo-syntax — check first; it's unambiguous.
    for name, body in _CALL_SYNTAX_RE.findall(content):
        if name not in valid_names:
            continue
        args = {k: _coerce_scalar(v) for k, v in _KV_RE.findall(body)}
        out.append(ToolCall(id=f"call_{uuid.uuid4().hex[:8]}", name=name, arguments=args))
    if out:
        return out

    # 1 + 2. Tag-wrapped or bare JSON.
    blocks = _TOOL_CALL_TAG_RE.findall(content)
    if blocks:
        candidates = blocks
    else:
        stripped = _FENCE_RE.sub("", content).strip()
        try:
            whole = _json.loads(stripped)
            candidates = (
                [_json.dumps(x) for x in whole]
                if isinstance(whole, list)
                else [_json.dumps(whole)]
            )
        except Exception:
            candidates = _JSON_OBJ_RE.findall(stripped)

    for c in candidates:
        try:
            obj = _json.loads(c)
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
                args = _json.loads(args)
            except Exception:
                args = {}
        out.append(ToolCall(
            id=f"call_{uuid.uuid4().hex[:8]}",
            name=name,
            arguments=args if isinstance(args, dict) else {},
        ))
    return out


def serialize_messages(messages: list) -> list[dict[str, Any]]:
    """Convert nova_contracts Message objects to plain dicts for LLM APIs.

    Handles multimodal content blocks and passes through cache_control
    for Anthropic prompt caching.
    """
    out = []
    for m in messages:
        # Handle multimodal content (list of ContentBlocks or dicts) or plain string
        if isinstance(m.content, list):
            content: Any = []
            for b in m.content:
                if isinstance(b, dict):
                    # Already a dict (e.g., from _build_prompt with cache_control)
                    content.append(b)
                elif hasattr(b, "type"):
                    block: dict[str, Any] = {"type": b.type}
                    if b.text is not None:
                        block["text"] = b.text
                    if b.image_url is not None:
                        block["image_url"] = b.image_url
                    if hasattr(b, "cache_control") and b.cache_control:
                        block["cache_control"] = b.cache_control
                    content.append(block)
                else:
                    content.append(b)
        else:
            content = m.content
        msg: dict = {"role": m.role, "content": content}
        if m.tool_calls:
            msg["tool_calls"] = [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.name, "arguments": _json.dumps(tc.arguments)}}
                for tc in m.tool_calls
            ]
        if m.tool_call_id:
            msg["tool_call_id"] = m.tool_call_id
        if m.name:
            msg["name"] = m.name
        out.append(msg)
    return out
