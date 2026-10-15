"""Her component-block catalog (S54a T12).

ui_blocks.json beside this file is written by the web registry's export test
(apps/web/src/components/ui-blocks/export.test.ts, UPDATE_UI_BLOCKS=1), never
by hand. catalog_prompt() turns it into the section stable_system_prompt places
immediately before ANSWER_LAYOUT, so a block registered in the web app reaches
her prompt with no edit here: nothing in this module names a block type.

The text follows ANSWER_LAYOUT's prompt-craft rules: imperatives, no
answer-shaped sentences she could echo, each block as its one-line use plus
its example. It is in every prompt, so it stays compact.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import jsonschema

PATH = Path(__file__).with_name("ui_blocks.json")
ERROR_CHARS = 300


@lru_cache(maxsize=1)
def load() -> dict:
    return json.loads(PATH.read_text(encoding="utf-8"))


def catalog_prompt() -> str:
    """The catalog section, read through load() on every call (no text cache)."""
    data = load()
    limits = data.get("limits", {})
    lines = [
        "\n\nComponent blocks. The chat app draws a ```nova-ui fence holding one JSON "
        "object as a component; markdown stays the base of every reply. Use a block "
        "only when it carries structure prose would bury (ordered steps, layers, "
        "options side by side), never for a short answer, and at most 3 per reply. "
        "Put one sentence before each block saying what it shows, and keep the prose "
        "understandable without the blocks. Write the JSON exactly as the examples: "
        "no other keys, no colours or HTML; nest at most "
        f"{limits.get('maxDepth')} levels and {limits.get('maxNodes')} nodes. "
        "Icons are only these names: " + ", ".join(data.get("icons", [])) + ". Blocks:"
    ]
    for b in data.get("blocks", []):
        lines.append(f"- {b['type']}: {b['describe']} Example: {json.dumps(b['example'])}")
    return "\n".join(lines)


# A fence opener / closer line (CommonMark: up to 3 spaces of indent, a run of
# >= 3 backticks or tildes). Matched one LINE at a time, never across the
# reply, so the scan is linear in the reply's length (guard-regex timing rule).
_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$")
_CLOSE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*$")


def fences(reply: str) -> list[str]:
    """The bodies of the CLOSED ```nova-ui fences in `reply`, in order.

    Every fence is tracked, whatever its language, so a ```nova-ui line quoted
    inside a ```markdown fence is that fence's text, not a block. A fence the
    reply never closes (a streaming tail, a truncated reply) is not a block:
    the browser shows it as code, so it is not counted."""
    bodies: list[str] = []
    lines = reply.split("\n")
    i = 0
    while i < len(lines):
        opened = _OPEN.match(lines[i])
        if not opened:
            i += 1
            continue
        marker, lang = opened.group(1), opened.group(2)
        body: list[str] = []
        j = i + 1
        while j < len(lines):
            closed = _CLOSE.match(lines[j])
            if closed and closed.group(1)[0] == marker[0] and len(closed.group(1)) >= len(marker):
                break
            body.append(lines[j])
            j += 1
        if j < len(lines) and lang == "nova-ui":
            bodies.append("\n".join(body))
        i = j + 1
    return bodies


def _is_node(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("type"), str)


def _children(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return list(value.values())
    return []


def _count_nodes(value: Any) -> int:
    """Objects carrying a string `type`, anywhere in the value (validate.ts)."""
    return (1 if _is_node(value) else 0) + sum(_count_nodes(c) for c in _children(value))


def _depth(value: Any) -> int:
    """Nesting depth of typed nodes; untyped objects and lists are transparent
    (validate.ts depthOf: a composite's `items` list is its data, not a level)."""
    below = max((_depth(c) for c in _children(value)), default=0)
    return below + (1 if _is_node(value) else 0)


def _one_line(text: str) -> str:
    return " ".join(str(text).split())


# (the load() result they were built from, one validator per type): rebuilt
# whenever load() hands back a different object, so clearing load's cache (a
# new catalog) can never leave validators for the old one in place.
_BUILT: tuple[Any, dict[str, Any]] | None = None


def _validators() -> dict[str, Any]:
    """One jsonschema validator per exported block type, built from load()."""
    global _BUILT
    data = load()
    if _BUILT is None or _BUILT[0] is not data:
        out: dict[str, Any] = {}
        for b in data.get("blocks", []):
            cls = jsonschema.validators.validator_for(b["schema"])
            out[b["type"]] = cls(b["schema"])
        _BUILT = (data, out)
    return _BUILT[1]


def validate(source: str) -> tuple[str | None, str | None]:
    """(type, None) for a valid block, (None, one-line error) otherwise.

    The same order as the browser's validateBlock: JSON, one object, a type
    the registry knows, the exported limits, then the block's exported JSON
    Schema. The zod refinements that do not survive toJSONSchema (a choices
    default among its options, its placeholders) are not re-checked here; the
    browser still refuses those and shows the code."""
    try:
        block = json.loads(source)
    except ValueError as exc:
        return None, f"not valid JSON: {_one_line(exc)}"
    if not isinstance(block, dict):
        return None, "a block must be one JSON object"
    kind = block.get("type")
    if not isinstance(kind, str) or not kind:
        return None, 'missing "type"'
    validator = _validators().get(kind)
    if validator is None:
        return None, f'unknown type "{_one_line(kind)}"'
    limits = load().get("limits", {})
    max_depth, max_nodes = limits.get("maxDepth"), limits.get("maxNodes")
    depth = _depth(block)
    if isinstance(max_depth, int) and depth > max_depth:
        return None, f"nesting depth {depth} is over the limit of {max_depth}"
    nodes = _count_nodes(block)
    if isinstance(max_nodes, int) and nodes > max_nodes:
        return None, f"{nodes} nodes is over the limit of {max_nodes}"
    error = jsonschema.exceptions.best_match(validator.iter_errors(block))
    if error is not None:
        path = ".".join(str(p) for p in error.absolute_path) or "(block)"
        # One line, capped: jsonschema quotes the failing value whole, and a
        # span's error is a pointer to what broke, not the block again.
        return None, f"{path}: {_one_line(error.message)}"[:ERROR_CHARS]
    return kind, None


def check(reply: str) -> dict:
    """The facts about her blocks in `reply`, for the turn's `ui_blocks` span:
    {ui_blocks: closed nova-ui fences, invalid: how many failed, first_error:
    the first failure's one-line error or None, types: the valid blocks' types
    in reply order}. Facts only: the reply is never changed."""
    blocks = fences(reply)
    types: list[str] = []
    invalid = 0
    first_error: str | None = None
    for body in blocks:
        kind, error = validate(body)
        if kind is not None:
            types.append(kind)
            continue
        invalid += 1
        if first_error is None:
            first_error = error
    return {
        "ui_blocks": len(blocks),
        "invalid": invalid,
        "first_error": first_error,
        "types": types,
    }
