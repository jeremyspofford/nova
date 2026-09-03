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

TWO PRECISION RULES, both from the adversarial review of 2026-09-03, and both
about the same danger from opposite sides. This code decides whether text
becomes an ACTION and whether text survives as PROSE, so it must never:

  * make quoted text cause an action. A reply that SHOWS what a tool call looks
    like — in a fenced code block, an inline code span, a markdown blockquote —
    is teaching, not calling. The review's repro ran `markup_probe` out of a
    ```xml fence, and pulled ["rm", "-rf", "/"] out of an explanation. So every
    region that is quotation BY CONSTRUCTION is masked before any tag is
    matched, and text inside it is returned byte for byte.
  * delete prose that was never a call. A block is removed only when it holds a
    call this can actually READ; an answer explaining "<function_calls> … opens
    it and </function_calls> closes it" keeps every character. Nothing is ever
    stripped merely because it mentions a tag.

The rest of the contract:

  * PURE — no model, no network, no clock, no imports from the app. The same
    text always yields the same scan, so this can never itself become a source
    of narration, and chat.py can run it on every round for the price of one
    substring search on the common (no-markup) path.
  * Nothing is inferred. A block that cannot be read honestly is reported as
    `unparsed`, and the caller DISPATCHES NOTHING from a round that carries one
    — a half-read call is how the review got `argv` from a quoted example onto
    a real call.
  * `streamed=True` is the only mode that will truncate. A round's text can stop
    mid-block, and half an emitted call is not prose; a finished record (the
    persist boundary, a redirect's reply) is never partial, so there the rule
    would only ever eat an honest sentence.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

# An optional XML namespace prefix — `antml:`, `atem:`, `tool:`, or nothing.
# The prefix is what a confused model mangles, so it is never matched literally.
_NS = r"(?:[A-Za-z_][\w.\-]*:)?"
# A tool name, shaped like a real one. `name="the tool you want"` is prose.
_NAME = r"[A-Za-z_][\w.\-]*"

# The whole block. Non-greedy body, DOTALL, and the closing tag's prefix is not
# required to match the opener's: a model that mangles the prefix once mangles
# it twice, differently.
_BLOCK = re.compile(
    rf"<\s*{_NS}function_calls\s*>(?P<body>.*?)<\s*/\s*{_NS}function_calls\s*>",
    re.S | re.I,
)
_INVOKE = re.compile(
    rf"<\s*{_NS}invoke\s+name\s*=\s*(?P<q>[\"'])(?P<name>{_NAME})(?P=q)\s*>"
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

# Any tag of the family, used ONLY to notice markup left over inside something
# already being read — never to delete anything on its own. A stray tag cannot
# cause an action, and deleting one deletes prose.
_ANY_TAG = re.compile(
    rf"<\s*/?\s*{_NS}(?:function_calls|invoke|parameter)\b|<\s*/?\s*tool_call\b", re.I
)
# An opening tag with no partner, and the shape that says a real call was being
# emitted when the text stopped: a quoted name attribute, which prose ("nests
# <invoke name=…>") does not have.
_OPENER = re.compile(rf"<\s*{_NS}(?:function_calls|invoke)\b|<\s*tool_call\s*>", re.I)
_INVOKE_START = re.compile(rf"<\s*{_NS}invoke\s+name\s*=\s*[\"']{_NAME}", re.I)

# The cheap bail: no text can carry any of the shapes above without one of
# these substrings, so ordinary prose costs one lowercase find and nothing else.
_MARKERS = ("function_calls", "invoke", "parameter", "tool_call")

# Quotation BY CONSTRUCTION — masked before anything is matched.
_FENCE_LINE = re.compile(r"(`{3,}|~{3,})")
_QUOTE_LINE = re.compile(r"^[ \t]{0,3}>[^\n]*", re.M)
# A code span, bounded by a matching backtick run and forbidden from crossing a
# blank line: an unterminated backtick must not swallow the rest of the reply.
_INLINE_CODE = re.compile(r"(?P<t>`+)(?:(?!\n[ \t]*\n).)+?(?P=t)", re.S)

_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")
_BLANK_RUN = re.compile(r"\n{3,}")
_MASK = "\x00"


def no_tool_round_note(names) -> str:
    """The honest stand-in for a reply that was ONLY a call this could not make:
    "[I tried to run X but had no tool round left …]", X derived from the calls
    actually refused, deduplicated, in order; "a tool" when none can be named.

    Backend-authored, like the round-cap note: never the model's prose, so it is
    not guard-vetted and must survive a REPLACE-class correction. It states two
    true things — the call did not run, and asking again will run it.
    """
    named = ", ".join(dict.fromkeys(n for n in names if n)) or "a tool"
    return (
        f"[I tried to run {named} but had no tool round left — "
        "ask again and I'll run it]"
    )


# The other honest note: markup that could not be read. "No tool round left"
# would be a guess about WHY nothing ran; what is known is that the call came
# out malformed and was therefore never dispatched.
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
    whether anything was too malformed to READ.

    `unparsed` is not advisory. A round whose markup did not fully parse
    dispatches NOTHING (chat.py refuses every call it carried): the review's
    nested-block repro parsed a quoted example's argv onto a real call and ran
    it, and a call assembled out of two different tags is not the call the model
    asked for.
    """

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


# -- quotation is masked before anything is read ---------------------------


def _fence_spans(text: str) -> list[tuple[int, int]]:
    """Fenced code blocks, including one left open at the end of the text."""
    spans: list[tuple[int, int]] = []
    position = 0
    opened_at: int | None = None
    marker = ""
    for line in text.splitlines(keepends=True):
        fence = _FENCE_LINE.match(line.lstrip(" \t"))
        if opened_at is None:
            if fence is not None:
                opened_at, marker = position, fence.group(1)[0]
        elif fence is not None and fence.group(1)[0] == marker:
            spans.append((opened_at, position + len(line)))
            opened_at = None
        position += len(line)
    if opened_at is not None:
        spans.append((opened_at, len(text)))
    return spans


def _mask(text: str) -> str:
    """`text` with every quoted region replaced by filler of the SAME length.

    Offsets are preserved, so a match found in the masked copy names a real span
    of the original; and because the tags inside a quotation are gone from the
    copy, no pattern can match there at all. Newlines survive masking so the
    line-anchored blockquote rule still sees real lines.
    """
    chars = list(text)

    def blank(start: int, end: int) -> None:
        for index in range(start, end):
            if chars[index] != "\n":
                chars[index] = _MASK

    for start, end in _fence_spans(text):
        blank(start, end)
    # Blockquotes and code spans are found on the already-masked copy, so a ">"
    # or a backtick inside a fence is not mistaken for one of its own.
    for match in _QUOTE_LINE.finditer("".join(chars)):
        blank(*match.span())
    for match in _INLINE_CODE.finditer("".join(chars)):
        blank(*match.span())
    return "".join(chars)


def _overlaps(span: tuple[int, int], taken: list[tuple[int, int]]) -> bool:
    return any(span[0] < end and start < span[1] for start, end in taken)


# -- reading one call ------------------------------------------------------


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


def _call_from_invoke(
    match: re.Match, text: str, masked: str
) -> tuple[ParsedCall, bool]:
    """(the call, whether reading it left any doubt).

    Doubt is never resolved by guessing. A parameter VALUE that contains another
    tag means the non-greedy match closed on the wrong `</parameter>` — the
    review's nested-quote repro, where a quoted example's argv replaced the real
    one — and so does markup left in the body that no parameter accounted for.
    Either way the call is returned (the caller refuses it, and says so, rather
    than dropping it silently) with `doubt` set, and nothing it names will run.
    """
    name = text[match.start("name") : match.end("name")]
    body_start, body_end = match.span("body")
    arguments: dict[str, object] = {}
    doubt = False
    covered: list[tuple[int, int]] = []
    for param in _PARAM.finditer(masked, body_start, body_end):
        raw = text[param.start("value") : param.end("value")]
        if _ANY_TAG.search(masked, param.start("value"), param.end("value")):
            doubt = True
        arguments[text[param.start("key") : param.end("key")].strip()] = _value(raw)
        covered.append(param.span())
    residue = "".join(
        masked[start:end]
        for start, end in _gaps(body_start, body_end, covered)
    )
    if _ANY_TAG.search(residue):
        doubt = True
    if arguments:
        return ParsedCall(name, arguments), doubt
    # No parameter tags at all: either a no-argument call, or a model that put
    # a JSON object in the body. Nothing is invented — an unreadable body
    # travels on as a string and dispatch states why.
    leftover = text[body_start:body_end].strip()
    if not leftover:
        return ParsedCall(name, {}), doubt
    if leftover[:1] == "{":
        try:
            parsed = json.loads(leftover)
        except json.JSONDecodeError:
            return ParsedCall(name, leftover), doubt
        return ParsedCall(name, parsed if isinstance(parsed, dict) else leftover), doubt
    return ParsedCall(name, leftover), doubt


def _gaps(start: int, end: int, taken: list[tuple[int, int]]):
    """The parts of [start, end) that `taken` does not cover."""
    cursor = start
    for span_start, span_end in sorted(taken):
        if span_start > cursor:
            yield cursor, span_start
        cursor = max(cursor, span_end)
    if cursor < end:
        yield cursor, end


# -- the scan --------------------------------------------------------------


def parse_markup_tool_calls(text: str, *, streamed: bool = False) -> MarkupScan:
    """Scan one piece of model text for tool-call markup.

    Returns the calls it recovered, the text with those calls removed, and
    whether anything was left that could not be read honestly. Nothing here
    decides what happens next: the caller dispatches (an open round, and only
    when nothing was `unparsed`) or refuses (a closed round, or anything
    unparsed), and either way the markup never survives into the durable record.

    `streamed` says the text may have stopped mid-emission. Only then is a
    half-emitted call — an unclosed opener with a quoted invoke name after it —
    dropped to the end of the text.
    """
    if not text:
        return _EMPTY
    lowered = text.lower()
    if not any(marker in lowered for marker in _MARKERS):
        return MarkupScan((), text, False)

    masked = _mask(text)
    calls: list[ParsedCall] = []
    removals: list[tuple[int, int]] = []
    # Regions a COMPLETE block accounted for, whether or not it was removed: a
    # block left standing because it is prose about tags must not then be read
    # again as a truncated call.
    resolved: list[tuple[int, int]] = []
    unparsed = False

    for block in _BLOCK.finditer(masked):
        resolved.append(block.span())
        body_start, body_end = block.span("body")
        invokes = list(_INVOKE.finditer(masked, body_start, body_end))
        if not invokes:
            # A block with nothing readable in it is PROSE ABOUT TAGS — the
            # answer explaining what a call looks like. Byte for byte.
            continue
        if _PARAGRAPH_BREAK.search(masked, body_start, invokes[0].start()):
            # A paragraph between the opener and the first invoke is writing,
            # not a call: a model emitting one does not stop for a blank line
            # and a new sentence. The cheapest bound that separates the two.
            continue
        block_doubt = False
        for invoke in invokes:
            call, doubt = _call_from_invoke(invoke, text, masked)
            calls.append(call)
            block_doubt = block_doubt or doubt
        residue = "".join(
            masked[start:end]
            for start, end in _gaps(body_start, body_end, [i.span() for i in invokes])
        )
        if _ANY_TAG.search(residue):
            block_doubt = True
        unparsed = unparsed or block_doubt
        removals.append(block.span())

    # A complete invoke outside any block is still unambiguously a call.
    for invoke in _INVOKE.finditer(masked):
        if _overlaps(invoke.span(), resolved):
            continue
        call, doubt = _call_from_invoke(invoke, text, masked)
        calls.append(call)
        unparsed = unparsed or doubt
        removals.append(invoke.span())
        resolved.append(invoke.span())

    for tool_call in _TOOL_CALL.finditer(masked):
        if _overlaps(tool_call.span(), resolved):
            continue
        resolved.append(tool_call.span())
        body = text[tool_call.start("body") : tool_call.end("body")].strip()
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            unparsed = True
            removals.append(tool_call.span())
            continue
        name = payload.get("name") if isinstance(payload, dict) else None
        if not isinstance(name, str) or not name.strip():
            unparsed = True
            removals.append(tool_call.span())
            continue
        arguments = payload.get("arguments", {})
        if not isinstance(arguments, (dict, str)):
            arguments = {}
        calls.append(ParsedCall(name.strip(), arguments))
        removals.append(tool_call.span())

    if streamed:
        for opener in _OPENER.finditer(masked):
            if _overlaps(opener.span(), resolved) or _overlaps(opener.span(), removals):
                continue
            tail = masked[opener.start() :]
            emitted_call = _INVOKE_START.search(tail) is not None or (
                tail.lower().startswith("<tool_call>")
                and tail[len("<tool_call>") :].lstrip()[:1] == "{"
            )
            if not emitted_call:
                # A bare mention of a tag, not a call cut off mid-emission.
                continue
            removals.append((opener.start(), len(text)))
            unparsed = True
            break

    if not removals:
        # Nothing was a call. The text is returned EXACTLY as it came in —
        # precision over tidiness, and the reason a quoted example survives.
        return MarkupScan(tuple(calls), text, unparsed)
    kept = "".join(text[start:end] for start, end in _gaps(0, len(text), removals))
    return MarkupScan(tuple(calls), _BLANK_RUN.sub("\n\n", kept).strip(), unparsed)
