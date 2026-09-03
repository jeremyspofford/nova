"""Tool-call MARKUP that arrived as reply TEXT — parsed here, never persisted.

The owner's walk, 2026-09-03 11:57, on a local model served through Ollama's
OpenAI-compatible endpoint: the consent redirect's CLOSING round advertises no
tools by design, the model wanted to adapt `device_run tree` (executable not
found) to `find`, and — with no tool call available to it — it wrote the call
out as text:

    <atem:function_calls>
      <atem:invoke name="device_run">
        <atem:parameter name="device">DELL-XPS-8950</atem:parameter>
        <atem:parameter name="argv">["find", "/home/jeremy", "-maxdepth", "2"]</atem:parameter>
      </atem:invoke>
    </atem:function_calls>

That text is an attempted ACTION, not a lie, a denial or a state claim, so all
four honesty guards pass it — and it was persisted as the assistant's reply.
The operator saw a raw XML blob, and the NEXT turn reads it back out of history
and learns to write more of them.

This module is the mechanical answer, and it is a MODEL-FORMAT ACCOMMODATION,
not a prompt: a model that speaks Claude-style XML (the "atem" prefix is a
mangled "antml"; the same model has leaked `<atem:parameter …>` into a JSON
argument value) is understood rather than asked to stop. Any namespace prefix
is accepted, because the prefix is exactly the part these models get wrong.

The contract:

  * PURE — no model, no network, no clock, no imports from the app. The same
    text always yields the same scan, so this can never itself become a source
    of narration, and chat.py can run it on every round for the price of one
    substring search on the common (no-markup) path.
  * PRECISION-first, like the guard family. Only a real tag shape matches: an
    optional namespace prefix followed by `function_calls`, `invoke` or
    `parameter`. Prose containing a bare "<" ("a < b") or the words "function
    calls" is never touched.
  * Nothing is inferred. A malformed or unclosed block cannot be dispatched and
    must not be shown, so it is STRIPPED and reported as `unparsed` — the
    caller states that plainly rather than guessing at what was meant.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

# An optional XML namespace prefix — `antml:`, `atem:`, `tool:`, or nothing.
# The prefix is what a confused model mangles, so it is never matched literally.
_NS = r"(?:[A-Za-z_][\w.\-]*:)?"

# The whole block. Non-greedy body, DOTALL, and the closing tag's prefix is not
# required to match the opener's: a model that mangles the prefix once mangles
# it twice, differently.
_BLOCK = re.compile(
    rf"<\s*{_NS}function_calls\s*>(?P<body>.*?)<\s*/\s*{_NS}function_calls\s*>",
    re.S | re.I,
)
_INVOKE = re.compile(
    rf"<\s*{_NS}invoke\s+name\s*=\s*(?P<q>[\"'])(?P<name>[^\"'<>]+)(?P=q)\s*>"
    rf"(?P<body>.*?)<\s*/\s*{_NS}invoke\s*>",
    re.S | re.I,
)
_PARAM = re.compile(
    rf"<\s*{_NS}parameter\s+name\s*=\s*(?P<q>[\"'])(?P<key>[^\"'<>]+)(?P=q)\s*>"
    rf"(?P<value>.*?)<\s*/\s*{_NS}parameter\s*>",
    re.S | re.I,
)
# The Hermes/Qwen JSON variant, which several local builds emit instead.
_TOOL_CALL = re.compile(r"<\s*tool_call\s*>(?P<body>.*?)<\s*/\s*tool_call\s*>", re.S | re.I)

# An OPENING tag with no partner — a stream that stopped mid-block. Everything
# from there on is markup, so it is dropped to the end of the text: half a tool
# call is not prose and must never be shown as an answer.
_TRUNCATED = re.compile(rf"<\s*{_NS}(?:function_calls|invoke)\b|<\s*tool_call\s*>", re.I)
# Any single leftover tag (a stray closer, an orphan parameter).
_STRAY = re.compile(rf"<\s*/?\s*{_NS}(?:function_calls|invoke|parameter)\b[^>]*>", re.I)
_STRAY_TOOL_CALL = re.compile(r"<\s*/?\s*tool_call\s*>", re.I)

# The cheap bail: no text can carry any of the shapes above without one of
# these substrings, so ordinary prose costs one lowercase find and nothing else.
_MARKERS = ("function_calls", "invoke", "parameter", "tool_call")

_BLANK_RUN = re.compile(r"\n{3,}")

# The honest note that stands in for a reply that was ONLY markup. It states
# two true things — the call did not run, and asking again will run it — and
# claims nothing. Backend-authored, like the round-cap note: never the model's
# prose, so it is not guard-vetted and must survive a REPLACE-class correction.
def no_tool_round_note(names) -> str:
    """"[I tried to run X but had no tool round left …]" — X derived from the
    calls actually found, deduplicated, in order; "a tool" when the markup was
    too malformed to name one."""
    named = ", ".join(dict.fromkeys(n for n in names if n)) or "a tool"
    return (
        f"[I tried to run {named} but had no tool round left — "
        "ask again and I'll run it]"
    )


# The other honest note: markup that could not be parsed at all. "No tool round
# left" would be a guess about WHY nothing ran, and the true statement here is
# just that the call came out malformed.
MALFORMED_MARKUP_NOTE = (
    "[I tried to write a tool call but it came out malformed, so nothing ran — "
    "ask again and I'll run it]"
)


@dataclass(frozen=True)
class ParsedCall:
    """One tool call recovered from reply text.

    `arguments` is a dict when the parameters were readable, and the raw string
    when they were not — the caller hands either to the ordinary dispatch path,
    whose argument parsing and schema validation state the problem in the one
    place that already knows how.
    """

    name: str
    arguments: dict | str


@dataclass(frozen=True)
class MarkupScan:
    """What one scan found: the calls, the text with the markup removed, and
    whether anything was too malformed to parse (which is never dispatched and
    never shown)."""

    calls: tuple[ParsedCall, ...]
    text: str
    unparsed: bool

    @property
    def found(self) -> bool:
        return bool(self.calls) or self.unparsed

    @property
    def names(self) -> list[str]:
        return [call.name for call in self.calls]


_EMPTY = MarkupScan((), "", False)


def _value(raw: str) -> object:
    """A parameter's value: JSON when it looks like JSON and parses, else the
    literal string. A value that merely STARTS like JSON and does not parse
    stays a string — guessing at a repair would invent an argument."""
    text = raw.strip()
    if text[:1] in ("[", "{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text


def _call_from_invoke(match: re.Match) -> ParsedCall:
    name = match.group("name").strip()
    body = match.group("body")
    arguments = {p.group("key").strip(): _value(p.group("value")) for p in _PARAM.finditer(body)}
    if arguments:
        return ParsedCall(name, arguments)
    # No parameter tags at all: either a no-argument call, or a model that put
    # a JSON object in the body. Both are handled without inventing anything —
    # an unreadable body travels on as a string and dispatch states why.
    leftover = _STRAY.sub("", body).strip()
    if not leftover:
        return ParsedCall(name, {})
    if leftover[:1] == "{":
        try:
            parsed = json.loads(leftover)
        except json.JSONDecodeError:
            return ParsedCall(name, leftover)
        return ParsedCall(name, parsed if isinstance(parsed, dict) else leftover)
    return ParsedCall(name, leftover)


def parse_markup_tool_calls(text: str) -> MarkupScan:
    """Scan one piece of model text for tool-call markup.

    Returns the calls it recovered, the text with every trace of markup removed,
    and whether anything was left that could not be parsed. Nothing here decides
    what happens next: the caller dispatches (when the round advertised tools) or
    refuses (when it did not), and either way the markup never survives into the
    durable record.
    """
    if not text:
        return _EMPTY
    lowered = text.lower()
    if not any(marker in lowered for marker in _MARKERS):
        return MarkupScan((), text, False)

    calls: list[ParsedCall] = []
    unparsed = False

    def _take_block(match: re.Match) -> str:
        nonlocal unparsed
        body = match.group("body")
        found = list(_INVOKE.finditer(body))
        calls.extend(_call_from_invoke(invoke) for invoke in found)
        remainder = _INVOKE.sub("", body)
        if not found or _STRAY.search(remainder):
            # A block with no readable invoke, or with markup left over after
            # the readable ones, carried something this cannot honestly claim
            # to have understood.
            unparsed = True
        return ""

    def _take_invoke(match: re.Match) -> str:
        calls.append(_call_from_invoke(match))
        return ""

    def _take_tool_call(match: re.Match) -> str:
        nonlocal unparsed
        try:
            payload = json.loads(match.group("body").strip())
        except json.JSONDecodeError:
            unparsed = True
            return ""
        name = payload.get("name") if isinstance(payload, dict) else None
        if not isinstance(name, str) or not name.strip():
            unparsed = True
            return ""
        arguments = payload.get("arguments", {})
        if not isinstance(arguments, (dict, str)):
            arguments = {}
        calls.append(ParsedCall(name.strip(), arguments))
        return ""

    out = _BLOCK.sub(_take_block, text)
    # A complete invoke outside any block is still unambiguously a tool call.
    out = _INVOKE.sub(_take_invoke, out)
    out = _TOOL_CALL.sub(_take_tool_call, out)

    truncated = _TRUNCATED.search(out)
    if truncated is not None:
        out = out[: truncated.start()]
        unparsed = True
    if _STRAY.search(out) or _STRAY_TOOL_CALL.search(out):
        out = _STRAY_TOOL_CALL.sub("", _STRAY.sub("", out))
        unparsed = True

    if not calls and not unparsed:
        # A marker word appeared in ordinary prose and no tag matched. The text
        # is returned EXACTLY as it came in — precision over tidiness.
        return MarkupScan((), text, False)
    return MarkupScan(tuple(calls), _BLANK_RUN.sub("\n\n", out).strip(), unparsed)
